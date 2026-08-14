import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
	throw new Error('Missing #root element');
}

createRoot(rootElement).render(
	<StrictMode>
		<main className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
			<h1 className="text-2xl font-semibold text-slate-950">gateship</h1>
			<p className="mt-2 text-sm text-slate-600">Web interface scaffold</p>
		</main>
	</StrictMode>,
);
