const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
	printReceipt: (receiptUrl) => ipcRenderer.invoke('print-receipt', receiptUrl),
});