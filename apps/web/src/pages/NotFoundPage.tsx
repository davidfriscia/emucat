import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <>
      <h1 className="h3 mb-3">Page not found</h1>
      <Link to="/">Back to the catalog</Link>
    </>
  );
}
