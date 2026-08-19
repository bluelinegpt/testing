import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { installCrashReporting } from './error-reporting';
import { installTracking } from './tracking';
import './styles.css';
import './quote.css';
import './blog.css';

installCrashReporting();
void installTracking();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
