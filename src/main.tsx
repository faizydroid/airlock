import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { syncRegistration } from './tools/tools.js';
import './ui/styles.css';

/**
 * There is no backend and no network call after this bundle loads.
 *
 * A reviewer can confirm that by grepping the built output: the only `fetch` in the codebase is
 * absent entirely. The dataset is generated in this tab from a seed, and every disclosure is
 * computed here. That absence is the product's central argument, so it is worth keeping true.
 */

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');

createRoot(el).render(<App />);

// Register the base tool group immediately, so an agent arriving at the page has something to
// discover before the human has done anything.
syncRegistration();
