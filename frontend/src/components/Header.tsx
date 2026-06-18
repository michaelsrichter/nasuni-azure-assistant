import { Link, NavLink } from 'react-router-dom';
import { APP_NAME, links } from '../config';
import type { Theme } from '../theme/useTheme';
import { BrandMark, MoonIcon, SunIcon } from './icons';

interface HeaderProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function Header({ theme, onToggleTheme }: HeaderProps) {
  return (
    <header className="site-header">
      <Link to="/" className="brand" aria-label={`${APP_NAME} home`}>
        <BrandMark />
        <span className="brand-name">{APP_NAME}</span>
      </Link>

      <nav className="site-nav" aria-label="Primary">
        <NavLink
          to="/architecture"
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Architecture
        </NavLink>
        <NavLink
          to="/knowledge-base"
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Knowledge Base
        </NavLink>
        <NavLink
          to="/costs"
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Costs
        </NavLink>
        <a className="nav-link" href={links.github} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <button
          type="button"
          className="icon-button theme-toggle"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </nav>
    </header>
  );
}
