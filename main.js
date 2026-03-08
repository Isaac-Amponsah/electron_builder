const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');

let mainWindow;
let phpServer;
let port;

const isDev = !app.isPackaged;
const MAX_PHP_RESTARTS = 3;
let phpRestartCount = 0;

/**
 * Find a free port — fresh server per attempt
 */
function findFreePort(start = 9000, end = 9999) {
	return new Promise((resolve, reject) => {
		let currentPort = start;

		function tryPort() {
			if (currentPort > end) {
				reject(new Error(`No free port found in range ${start}-${end}`));
				return;
			}

			const server = net.createServer();

			server.once('error', () => {
				currentPort++;
				tryPort();
			});

			server.once('listening', () => {
				server.close(() => resolve(currentPort));
			});

			server.listen(currentPort, '127.0.0.1');
		}

		tryPort();
	});
}

/**
 * Poll until PHP server is actually responding
 */
function waitForPHP(url, timeoutMs = 10000, intervalMs = 200) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;

		function check() {
			if (Date.now() > deadline) {
				reject(new Error('PHP server failed to start within timeout'));
				return;
			}

			http.get(url, () => {
				resolve();
			}).on('error', () => {
				setTimeout(check, intervalMs);
			});
		}

		check();
	});
}

/**
 * Create Electron window
 */
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	mainWindow.loadURL(`http://127.0.0.1:${port}`);

	if (isDev) {
		mainWindow.webContents.openDevTools();
	}
}

/**
 * Start PHP server with bounded restarts
 */
function startPHP() {
	if (phpRestartCount >= MAX_PHP_RESTARTS) {
		console.error(`PHP crashed ${MAX_PHP_RESTARTS} times. Giving up.`);
		app.quit();
		return;
	}

	const phpPath = app.isPackaged
		? path.join(process.resourcesPath, 'app.asar.unpacked', 'php', 'php.exe')
		: path.join(__dirname, 'php', 'php.exe');

	const posPublicPath = app.isPackaged
		? path.join(process.resourcesPath, 'pos_system', 'public')
		: path.join(__dirname, '..', 'pos_system', 'public');

	console.log('PHP PATH:', phpPath);
	console.log('PUBLIC PATH:', posPublicPath);

	// Verify PHP binary exists before spawning
	if (!fs.existsSync(phpPath)) {
		console.error(`FATAL: PHP binary not found at ${phpPath}`);
		app.quit();
		return;
	}

	if (!fs.existsSync(posPublicPath)) {
		console.error(`FATAL: Public directory not found at ${posPublicPath}`);
		app.quit();
		return;
	}

	phpServer = spawn(phpPath, [
		'-S', `127.0.0.1:${port}`,
		'-t', posPublicPath,
	]);

	phpServer.on('error', (err) => {
		console.error('Failed to start PHP process:', err.message);
		app.quit();
	});

	phpServer.stdout.on('data', (data) => {
		console.log(`PHP: ${data}`);
	});

	phpServer.stderr.on('data', (data) => {
		console.error(`PHP ERROR: ${data}`);
	});

	phpServer.on('exit', (code) => {
		console.warn(`PHP exited with code ${code}. Restart attempt ${phpRestartCount + 1}/${MAX_PHP_RESTARTS}`);
		phpRestartCount++;
		startPHP();
	});
}

/**
 * Kill PHP server reliably (Windows-aware)
 */
function killPHP() {
	if (!phpServer) return;

	phpServer.removeAllListeners('exit');

	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(phpServer.pid), '/f', '/t']);
	} else {
		phpServer.kill('SIGTERM');
	}

	phpServer = null;
}

/**
 * Silent receipt printing via IPC
 */
ipcMain.handle('print-receipt', async (_event, receiptUrl) => {
	return new Promise((resolve, reject) => {
		const receiptWindow = new BrowserWindow({ show: false });

		receiptWindow.loadURL(receiptUrl);

		receiptWindow.webContents.on('did-finish-load', () => {
			receiptWindow.webContents.print(
				{ silent: true, printBackground: true },
				(success, failureReason) => {
					receiptWindow.close();
					if (success) {
						resolve();
					} else {
						reject(new Error(failureReason));
					}
				}
			);
		});

		receiptWindow.webContents.on('did-fail-load', (_e, code, desc) => {
			receiptWindow.close();
			reject(new Error(`Failed to load receipt: ${desc} (${code})`));
		});
	});
});

/**
 * App startup
 */
app.whenReady().then(async () => {
	try {
		port = await findFreePort(9000, 9999);
		console.log('Using port:', port);

		const dbPath = path.join(app.getPath('userData'), 'database');
		if (!fs.existsSync(dbPath)) {
			fs.mkdirSync(dbPath, { recursive: true });
		}
		console.log('Database path:', dbPath);

		startPHP();

		await waitForPHP(`http://127.0.0.1:${port}`);
		console.log('PHP server is ready');

		createWindow();
	} catch (err) {
		console.error('Fatal startup error:', err.message);
		killPHP();
		app.quit();
	}
});

/**
 * Shutdown
 */
app.on('window-all-closed', () => {
	killPHP();
	app.quit();
});