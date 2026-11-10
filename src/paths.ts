import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultConfigDirectory = () => process.env.SAPLINK_CONFIG_DIR
  ?? join(process.env.APPDATA ?? homedir(), 'saplink');

export const defaultLogDirectory = () => process.env.SAPLINK_LOG_DIR
  ?? join(process.env.LOCALAPPDATA ?? homedir(), 'saplink', 'logs');

export const defaultMcpPort = () => process.env.SAPLINK_DEV_PREVIEW === '1' ? 18765 : 8765;
export const defaultUiPort = () => process.env.SAPLINK_DEV_PREVIEW === '1' ? 18766 : 8766;
