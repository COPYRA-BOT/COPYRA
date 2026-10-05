import { Buffer } from 'buffer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { WalletProvider } from './lib/wallet';
import './index.css';

if (!window.Buffer) {
  window.Buffer = Buffer;
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('COPYRA web failed to mount: #root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <WalletProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </WalletProvider>
  </StrictMode>,
);
