import { useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { APP_NAME, links } from '../config';
import type { Theme } from '../theme/useTheme';
import { BrandMark, CloseIcon, MenuIcon, MoonIcon, SunIcon } from './icons';

interface HeaderProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function Header({ theme, onToggleTheme }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  const closeMenu = () => setMenuOpen(false);

  // Close on Escape and on pointer events outside the nav while the menu is open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [menuOpen]);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `nav-link${isActive ? ' active' : ''}`;

  return (
    <header className="site-header">
      <Link to="/" className="brand" aria-label={`${APP_NAME} home`}>
        <BrandMark />
        <span className="brand-name">{APP_NAME}</span>
      </Link>

      <nav className={`site-nav${menuOpen ? ' open' : ''}`} aria-label="Primary" ref={navRef}>
        <button
          type="button"
          className="icon-button nav-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="primary-nav-links"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <CloseIcon /> : <MenuIcon />}
        </button>

        <div className="nav-links" id="primary-nav-links">
          <NavLink to="/architecture" className={navLinkClass} onClick={closeMenu}>
            Architecture
          </NavLink>
          <NavLink to="/knowledge-base" className={navLinkClass} onClick={closeMenu}>
            Knowledge Base
          </NavLink>
          <NavLink to="/costs" className={navLinkClass} onClick={closeMenu}>
            Costs
          </NavLink>
          <a
            className="nav-link"
            href={links.github}
            target="_blank"
            rel="noreferrer"
            onClick={closeMenu}
          >
            GitHub
          </a>
        </div>

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
