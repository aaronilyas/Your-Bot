/** Only these fixed channels are ever exposed through the preload. */
export const IPC = { dispatch: 'your-bot:dispatch', event: 'your-bot:event', chooseDirectory: 'your-bot:choose-directory', loadAppearance: 'your-bot:appearance-load', saveAppearance: 'your-bot:appearance-save' } as const;
