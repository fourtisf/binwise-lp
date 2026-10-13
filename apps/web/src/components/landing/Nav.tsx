'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Logo } from '../Logo';

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 10);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={`nav${scrolled ? ' scrolled' : ''}`} id="nav">
      <Logo />
      <nav className="nav-links" aria-label="Sections">
        <a href="#product">Product</a>
        <a href="#how">How it works</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </nav>
      <div className="nav-r">
        <Link className="btn btn-dark btn-sm" href="/app">
          Sign in
        </Link>
        <Link className="btn btn-white btn-sm" href="/app">
          Launch app
        </Link>
      </div>
    </header>
  );
}
