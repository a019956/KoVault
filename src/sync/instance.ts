import { vault } from '../data/vault';
import { SyncEngine } from './syncEngine';

export const sync = new SyncEngine(vault);
