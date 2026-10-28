// Masthead and consulting footer shared with scottcampbell.io.
const CONSULTING = "https://scottcampbellconsulting.com/";
const CONTACT = "https://scottcampbellconsulting.com/contact/";

export function SiteBar({ caseStudy, repo }: { caseStudy: string; repo: string }) {
  return (
    <header className="pp-bar">
      <div className="pp-bar-inner">
        <a className="pp-brand" href="https://scottcampbell.io/">
          Scott Campbell
        </a>
        <nav className="pp-nav" aria-label="Site">
          <a href={caseStudy}>Case study</a>
          <a className="pp-nav-wide" href={repo}>Source</a>
          <a className="pp-nav-wide" href="https://scottcampbell.io/projects/">Projects</a>
          <a href={CONSULTING}>Consulting</a>
          <a href={CONTACT}>Contact</a>
        </nav>
      </div>
    </header>
  );
}

export function ConsultFooter({ caseStudy }: { caseStudy: string }) {
  return (
    <footer>
      <section className="pp-consult" aria-labelledby="pp-consult-title">
        <div className="pp-consult-inner">
          <div>
            <h2 id="pp-consult-title">Need analysis like this?</h2>
            <p>
              I build reporting, dashboards and analysis for small businesses
              through Scott Campbell Consulting.
            </p>
          </div>
          <div className="pp-actions">
            <a className="pp-btn" href={CONTACT}>
              Contact me
            </a>
            <a className="pp-link" href={CONSULTING}>
              Scott Campbell Consulting
            </a>
          </div>
        </div>
      </section>
      <p className="pp-credit">
        Made by <a href="https://scottcampbell.io/">Scott Campbell</a>. A
        portfolio project. Read the <a href={caseStudy}>case study</a>.
      </p>
    </footer>
  );
}
