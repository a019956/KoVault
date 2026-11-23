import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { vault } from './data/vault';
import { sync } from './sync/instance';
import './styles.css';

async function boot() {
  await vault.load();
  await sync.start();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot().catch((e) => {
  document.getElementById('root')!.textContent = `KoVault failed to start: ${e instanceof Error ? e.message : e}`;
});
