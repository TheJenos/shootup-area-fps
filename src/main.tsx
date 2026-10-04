import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in index.html');

// No <StrictMode>: its dev-only double mount would join, leave and rejoin the room,
// and leaving as the last player deletes the room.
createRoot(root).render(<App />);
