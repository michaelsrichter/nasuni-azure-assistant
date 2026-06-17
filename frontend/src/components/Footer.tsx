import { Link } from 'react-router-dom';
import { APP_NAME, links } from '../config';

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-col">
          <div className="footer-heading">{APP_NAME}</div>
          <p className="footer-note">
            A demo assistant for deploying Nasuni on Microsoft Azure, grounded in
            Nasuni documentation and Microsoft Learn.
          </p>
        </div>

        <div className="footer-col">
          <div className="footer-heading">Further reading</div>
          <ul className="footer-links">
            <li>
              <a href={links.foundry} target="_blank" rel="noreferrer">
                Microsoft Foundry
              </a>
            </li>
            <li>
              <a href={links.agentService} target="_blank" rel="noreferrer">
                Foundry Agent Service
              </a>
            </li>
            <li>
              <a href={links.hostedAgents} target="_blank" rel="noreferrer">
                Hosted Agents
              </a>
            </li>
            <li>
              <a href={links.knowledgeBases} target="_blank" rel="noreferrer">
                Knowledge Bases
              </a>
            </li>
          </ul>
        </div>

        <div className="footer-col">
          <div className="footer-heading">Project</div>
          <ul className="footer-links">
            <li>
              <a href={links.github} target="_blank" rel="noreferrer">
                GitHub repository
              </a>
            </li>
            <li>
              <a href={links.linkedIn} target="_blank" rel="noreferrer">
                Mike Richter on LinkedIn
              </a>
            </li>
            <li>
              <a href={links.nasuni} target="_blank" rel="noreferrer">
                Nasuni
              </a>
            </li>
          </ul>
        </div>

        <div className="footer-col">
          <div className="footer-heading">Legal</div>
          <ul className="footer-links">
            <li>
              <Link to="/privacy">Privacy</Link>
            </li>
            <li>
              <Link to="/terms">Terms of Service</Link>
            </li>
          </ul>
        </div>
      </div>

      <div className="footer-bottom">
        <span>© {year} Mike Richter. Demo project — not affiliated endorsement.</span>
      </div>
    </footer>
  );
}
