import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
try {
  const saved = localStorage.getItem('lingo-theme');
  document.documentElement.dataset.theme = saved === 'light' || saved === 'gruber' ? saved : 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

createRoot(root).render(<StrictMode><App /></StrictMode>);
