import { ArrowUpRight, CodeXml, Lock, Mail } from "lucide-react";
import { Link } from "react-router";

// Public front page. Content comes from Sam's resume. Deliberately no phone number and no private
// mailbox here: contact goes through an address on this domain, which the catch-all receives.

const CONTACT = "hello@eisenberg.dev";
const REPO = "https://github.com/seisenberg/eisenberg.dev";

const EXPERIENCE: { role: string; org: string; years: string; points: string[]; clients?: string }[] = [
  {
    role: "Independent Consultant, Fractional Technology Executive",
    org: "Self-employed",
    years: "2020 to present",
    clients: "Salomon & Ludwin, Book of the Month, Bookspan, 0xb8 Networks",
    points: [
      "Fractional CTO advising executive teams on technology strategy, platform decisions, and engineering team structure and hiring.",
      "Improving engineering discipline through development processes and procedures across DevOps and SRE.",
      "Architected and migrated production workloads to AWS and Azure.",
      "Embedded as a staff-level engineer to unblock critical projects and accelerate delivery.",
    ],
  },
  {
    role: "Senior Product Manager",
    org: "American Express",
    years: "2019 to 2020",
    points: [
      "Product manager for the central enterprise Kafka event bus rules and triggering system, handling millions of events each day across card, merchant, and servicing platforms.",
      "Produced product roadmaps, requirements, strategies, feedback loops, and KPIs and OKRs.",
      "Onboarded technologists and engineered draft solutions for downstream consumers.",
    ],
  },
  {
    role: "Vice President, Data and Analytics",
    org: "Pride Tree Holdings (Book of the Month)",
    years: "2017 to 2018",
    points: [
      "Head of product management for all enterprise applications: accounting, project management, warehouse management, inventory, customer support, and marketing.",
      "Architected, developed, and maintained the data warehouse, ETL, BI, and data science platform.",
      "Defined and implemented business models, KPIs, and marketing attribution.",
      "Automated business processes to scale through the growth phase from zero to more than 200,000 members.",
      "Hired, developed, and managed analysts and engineers in data, operations, and logistics.",
    ],
  },
  {
    role: "Director of Business Intelligence and Analytics",
    org: "Pride Tree Holdings (Bookspan)",
    years: "2015 to 2017",
    points: [
      "Managed a unified data team serving 7 departments across 13 brands.",
      "Led all business intelligence and analytical initiatives and partnered with executive leadership to set company direction.",
      "Increased resilience and efficiency by replacing third-party vendors with in-house capability.",
      "Trained and mentored to raise the organization's analytical competency.",
    ],
  },
  {
    role: "Business Intelligence Engineer",
    org: "Blurb",
    years: "2013 to 2015",
    points: [
      "Partnered with Marketing, Finance, and Product under a center of excellence model.",
      "Scoped, specified, and built reports, dashboards, and automated workflows.",
      "Architected, developed, and administered business intelligence systems, databases, and Linux VMs.",
    ],
  },
  {
    role: "Business Analyst, Professional Services Academy Specialist",
    org: "MicroStrategy",
    years: "2011 to 2013",
    points: [
      "Consulted on strategic technical engagements and key accounts.",
      "Rescued escalated projects, including the AIG mobile BI launch and the Marsh & McLennan onboarding app.",
      "Set role standards, ran university recruiting, and delivered internal training for the consulting organization.",
    ],
  },
];

const SKILLS: { label: string; items: string[] }[] = [
  { label: "Focus", items: ["Solutions engineering", "Systems architecture", "DevOps", "Cloud migrations", "Reporting and dashboards", "Agentic development", "Team management"] },
  { label: "Languages and tools", items: ["SQL", "TypeScript", "Python", "Bash", "React", "Containers", "Linux", "Kubernetes"] },
  { label: "Databases", items: ["PostgreSQL", "MySQL", "SQL Server", "Redshift", "Vertica", "DuckDB", "Druid"] },
  { label: "Platforms", items: ["AWS", "Azure", "MicroStrategy", "NetSuite", "Tableau", "Jira", "Google Ads", "Meta Business", "Klaviyo"] },
];

const HIGHLIGHTS = [
  { value: "15 yrs", label: "across analytics, product, and cloud architecture" },
  { value: "0 to 200K+", label: "members scaled through at Book of the Month" },
  { value: "13 brands", label: "served by one unified data team" },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-muted-foreground mb-6 text-xs font-semibold tracking-[0.18em] uppercase">{children}</h2>;
}

export default function Portfolio() {
  return (
    <div className="bg-background min-h-full text-[15px] leading-relaxed">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <span className="font-semibold tracking-tight">eisenberg.dev</span>
        <nav className="text-muted-foreground flex items-center gap-5 text-sm">
          <a className="hover:text-foreground hidden sm:inline" href="#experience">Experience</a>
          <a className="hover:text-foreground hidden sm:inline" href="#skills">Skills</a>
          <a className="hover:text-foreground" href={`mailto:${CONTACT}`}>Contact</a>
          <Link to="/mail" className="hover:text-foreground -m-2 inline-flex items-center gap-1.5 p-2" aria-label="Private sign in">
            <Lock className="size-3.5" />
            <span className="hidden sm:inline">Sign in</span>
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-24">
        <section className="pt-8 pb-12 sm:pt-20 sm:pb-16">
          <p className="text-primary mb-4 text-sm font-medium">Fractional CTO · Staff engineer · Data and analytics leader</p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">Sam Eisenberg</h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg sm:text-xl">
            Technology and data leader who has led as a VP, advised as a fractional CTO, and built as a staff engineer. I own full technical footprints along
            with the teams behind them.
          </p>
          <p className="mt-4 max-w-2xl">
            Known for replacing vendor dependency with in-house capability, raising competency across entire organizations, and building systems and
            solutions that last.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={`mailto:${CONTACT}`} className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium hover:opacity-90">
              <Mail className="size-4" /> Get in touch
            </a>
            <a href="https://github.com/seisenberg" rel="noopener noreferrer" target="_blank" className="hover:bg-accent inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium">
              <CodeXml className="size-4" /> GitHub <ArrowUpRight className="text-muted-foreground size-3.5" />
            </a>
          </div>
        </section>

        <section className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
          {HIGHLIGHTS.map((h) => (
            <div key={h.label} className="bg-card p-5 sm:p-6">
              <div className="text-2xl font-semibold tracking-tight">{h.value}</div>
              <div className="text-muted-foreground mt-1 text-sm">{h.label}</div>
            </div>
          ))}
        </section>

        <section id="experience" className="scroll-mt-8 pt-20">
          <SectionTitle>Experience</SectionTitle>
          <ol className="space-y-12">
            {EXPERIENCE.map((job) => (
              <li key={job.role + job.org} className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:gap-8">
                <div className="text-muted-foreground pt-0.5 text-sm tabular-nums">{job.years}</div>
                <div>
                  <h3 className="text-base font-semibold">{job.role}</h3>
                  <div className="text-muted-foreground text-sm">{job.org}</div>
                  {job.clients && <div className="mt-2 text-sm"><span className="text-muted-foreground">Clients: </span>{job.clients}</div>}
                  <ul className="mt-3 space-y-1.5">
                    {job.points.map((p) => (
                      <li key={p} className="before:bg-muted-foreground/50 relative pl-4 before:absolute before:top-[0.7em] before:left-0 before:size-1 before:rounded-full">{p}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="skills" className="scroll-mt-8 pt-20">
          <SectionTitle>Skills</SectionTitle>
          <div className="space-y-6">
            {SKILLS.map((group) => (
              <div key={group.label} className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:gap-8">
                <div className="text-muted-foreground pt-1 text-sm">{group.label}</div>
                <div className="flex flex-wrap gap-2">
                  {group.items.map((item) => (
                    <span key={item} className="bg-secondary text-secondary-foreground rounded-full px-3 py-1 text-sm">{item}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="pt-20">
          <SectionTitle>Education</SectionTitle>
          <div className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:gap-8">
            <div className="text-muted-foreground pt-0.5 text-sm tabular-nums">2007 to 2011</div>
            <div>
              <h3 className="text-base font-semibold">University of Virginia, College of Arts and Sciences</h3>
              <ul className="mt-2 space-y-1">
                <li>Bachelor of Arts, Mathematics. Distinguished Major Program, Dean's List.</li>
                <li>Bachelor of Arts, Physics. Dean's List.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="pt-20">
          <SectionTitle>This site</SectionTitle>
          <div className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:gap-8">
            <div className="text-muted-foreground pt-0.5 text-sm">Open source</div>
            <div>
              <p>
                This page is the public face of a small system I built and run myself: catch-all mail for several domains with a private webmail, a
                reply relay that keeps my own mailbox hidden, push notifications, and a file drop. Two container Lambdas, one PostgreSQL database, and a
                few dollars a month.
              </p>
              <a href={REPO} rel="noopener noreferrer" target="_blank" className="text-primary mt-3 inline-flex items-center gap-1.5 font-medium hover:underline">
                Read the code and the security review <ArrowUpRight className="size-4" />
              </a>
            </div>
          </div>
        </section>

        <section className="bg-card mt-20 rounded-xl border p-8 sm:p-10">
          <h2 className="text-2xl font-semibold tracking-tight">Have a platform, team, or migration that needs an owner?</h2>
          <p className="text-muted-foreground mt-2 max-w-xl">I take on fractional CTO engagements and embedded staff-level work.</p>
          <a href={`mailto:${CONTACT}`} className="text-primary mt-5 inline-flex items-center gap-2 font-medium hover:underline">
            {CONTACT} <ArrowUpRight className="size-4" />
          </a>
        </section>
      </main>

      <footer className="text-muted-foreground mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-6 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-sm">
        <span>© {new Date().getFullYear()} Sam Eisenberg</span>
        <a href={REPO} rel="noopener noreferrer" target="_blank" className="hover:text-foreground inline-flex items-center gap-1.5">
          <CodeXml className="size-3.5" /> How this site is built
        </a>
        <Link to="/mail" className="hover:text-foreground inline-flex items-center gap-1.5"><Lock className="size-3.5" /> Private area</Link>
      </footer>
    </div>
  );
}
