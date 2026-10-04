// First: inside Discord this reroutes network traffic through Discord's proxy, and Firebase
// captures the WebSocket constructor as soon as it loads.
import './discord/patch';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { watchReducedMotion } from './game/settings';
import './style.css';

watchReducedMotion();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in index.html');

// No <StrictMode>: its dev-only double mount would join, leave and rejoin the room,
// and leaving as the last player deletes the room.
createRoot(root).render(<App />);
