import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadPrefs } from './prefs';
import './styles.css';

// Apply the stored theme before the first paint so launch never flashes the other palette.
applyTheme(loadPrefs().theme);

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');
createRoot(container).render(<App />);
