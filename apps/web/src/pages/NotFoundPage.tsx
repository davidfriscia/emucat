import { Link } from 'react-router';
import { Mascot } from '../components/Brand';

export function NotFoundPage() {
  return (
    <div className="text-center py-4">
      <title>Page not found · EmuCat</title>
      <Mascot mood="puzzled" size={96} />
      <h1 className="h3 mt-3 mb-3">Page not found</h1>
      <Link to="/">Back to the catalog</Link>
    </div>
  );
}
