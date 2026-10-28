import { ThemeToggle } from "@/components/ThemeToggle";

export const CASE_STUDY = "https://scottcampbell.io/projects/automotive-analyst/";
export const REPO = "https://github.com/scottcampbelldata/automotive-analyst";
const DASHBOARD_URL = "https://factory.scottcampbell.io";

// Title band and summary aside, as on the scottcampbell.io project pages.
export function ReportBand() {
  return (
    <div className="report-band">
      <div className="report-band-inner">
        <div>
          <div className="report-kicker">Assembly line analytics, text to SQL console</div>
          <h1>Automotive Analyst</h1>
          <p className="report-lead">
            Ask the assembly plant warehouse a question in plain English. Your model
            writes PostgreSQL, the server validates it through read-only guardrails and
            runs it, and you always see the query behind the answer.
          </p>
          <div className="report-tools">
            <span className="badge">
              <span className="dot" /> Read only, live
            </span>
            <ThemeToggle />
            <a href={DASHBOARD_URL} className="badge" target="_blank" rel="noreferrer">
              Factory dashboard &#8599;
            </a>
          </div>
        </div>
        <dl className="glance" aria-label="Project summary">
          <dt>The question</dt>
          <dd>Can a plain English question become SQL over a factory warehouse without trusting the model?</dd>
          <dt>The data</dt>
          <dd>The synthetic warehouse behind the factory dashboard. No proprietary or employer data.</dd>
          <dt>The result</dt>
          <dd>
            In testing the guardrail blocked 43 of 43 attack queries and accepted 16 of 16
            legitimate ones. <a href={CASE_STUDY}>Read the case study</a>.
          </dd>
        </dl>
      </div>
    </div>
  );
}
