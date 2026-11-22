import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Missing root element');

// A data router, so that a page with unsaved changes can ask before the application navigates away. The routes
// themselves stay declarative, in App.
const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
