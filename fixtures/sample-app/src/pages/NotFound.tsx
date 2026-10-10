import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <main className="notfound">
      <h1>Page not found</h1>
      <p>The page you asked for does not exist.</p>
      <Link to="/projects">Back to projects</Link>
    </main>
  );
}
