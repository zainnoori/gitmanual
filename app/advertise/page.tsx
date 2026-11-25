import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";
import { AD_PRICES, SOCIAL_URL, type AdNumber } from "@/lib/advertise";
import { adStats } from "@/lib/advertise-store";
import { FINDS_ON, PICKS } from "@/lib/picks";
import { REPO_URL } from "@/lib/site";
import { FacebookMark } from "../finds/post";
import { ProblemForm } from "../report-problem";
import { Logo } from "../ui";

export const metadata: Metadata = {
  title: "Advertise",
  description: "Put your product in front of developers while they set up open-source projects: on gitmanual's manual pages and on the Zain Finds social page.",
  alternates: { canonical: "/advertise" },
};

// The numbers are edited on /admin/advertise, which refreshes this page when it saves.
export const revalidate = 3600;

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

function Numbers({ list }: { list: AdNumber[] }) {
  return (
    <dl className="adv-nums">
      {list.map((n) => (
        <div key={n.label}>
          <dd>{n.value}</dd>
          <dt>{n.label}</dt>
        </div>
      ))}
    </dl>
  );
}

// A real page of the site, in a browser frame, with the ad's place marked.
function Shot({ src, path, alt }: { src: string; path: string; alt: string }) {
  return (
    <figure className="adv-shot">
      <div className="adv-shot-bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>gitmanual.com{path}</span>
      </div>
      <Image src={src} alt={alt} width={1600} height={900} sizes="(max-width: 860px) 100vw, 560px" />
    </figure>
  );
}

function Placement({ media, title, only, children }: { media: ReactNode; title: string; only?: string; children: ReactNode }) {
  return (
    <li className="adv-place">
      {media}
      <div className="adv-place-text">
        <h3>
          {title}
          {only && <span className="adv-only">{only}</span>}
        </h3>
        <p>{children}</p>
      </div>
    </li>
  );
}

// /advertise: who's here, where an ad goes, the two packages and the booking form (the contact inbox, topic "Advertising").
export default async function Advertise() {
  const stats = await adStats();
  const social = FINDS_ON;
  const page = PICKS.curator || "Zain Finds";
  const repoName = REPO_URL?.replace(/^https:\/\/github\.com\//, "") ?? "gitmanual";
  return (
    <article className="wrap adv">
      <header className="adv-hero">
        <div className="adv-head">
          <p className="eyebrow">Advertise on gitmanual</p>
          <h1 className="display-md">
            Reach developers <span className="adv-mark">while they set things up.</span>
          </h1>
          <p className="lead">
            People come to gitmanual to get an open-source project running on their own computer. Your product sits beside the steps,
            right when they&apos;re picking their tools
            {social ? (
              <>
                , and in front of the millions who watch{" "}
                <a href={SOCIAL_URL} target="_blank" rel="noreferrer">
                  {page}
                </a>
                , our page for open-source finds
              </>
            ) : null}
            .
          </p>
          <div className="adv-cta">
            <a className="btn btn-go" href="#book">
              Book a spot
            </a>
            <a className="btn" href="#packages">
              See the packages
            </a>
          </div>
          {stats.nextOpen && (
            <p className="adv-next">
              Next open month: <b>{stats.nextOpen}</b>
            </p>
          )}
        </div>

        {(stats.site.length > 0 || (social && stats.social.length > 0)) && (
          <aside className="adv-audience" aria-label="The audience">
            {stats.site.length > 0 && (
              <section>
                <h2 className="adv-audience-h">
                  <Logo size={18} /> gitmanual.com
                </h2>
                <Numbers list={stats.site} />
              </section>
            )}
            {social && stats.social.length > 0 && (
              <section>
                <h2 className="adv-audience-h">
                  <FacebookMark /> {page}
                  <a href={SOCIAL_URL} target="_blank" rel="noreferrer">
                    See the page ↗
                  </a>
                </h2>
                <Numbers list={stats.social} />
              </section>
            )}
            {stats.updated && <p className="adv-updated">Checked {stats.updated}</p>}
          </aside>
        )}
      </header>

      <section className="adv-section" aria-labelledby="adv-where">
        <p className="eyebrow">Placements</p>
        <h2 id="adv-where">Where your ad goes</h2>
        <p className="adv-sub">The orange box is your ad, in its real place on each page.</p>
        <ul className="adv-places">
          <Placement media={<Shot src="/advertise/manual.jpg" path="/ollama/ollama" alt="A manual page, with the ad in the right column beside the repo's stats" />} title="Manual pages">
            The right column of every public repo&apos;s manual, beside its stats and above the fold. Most of our traffic lands here.
          </Placement>
          <Placement media={<Shot src="/advertise/shelf.jpg" path="/shelf" alt="The shelf, with the ad at the top right beside the title" />} title="The shelf and lists">
            At the top of the pages where people browse for the next project to try.
          </Placement>
          <Placement media={<Shot src="/advertise/developers.jpg" path="/developers" alt="The API and MCP page, with the ad at the top right" />} title="Developer pages">
            The API and MCP pages, read by people wiring gitmanual into their own tools and AI agents.
          </Placement>
          <Placement
            only="Exclusive"
            title="gitmanual's README on GitHub"
            media={
              <figure className="adv-readme" aria-label="gitmanual's README on GitHub, with a sponsor logo under the title">
                <div className="adv-shot-bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <span>github.com/{repoName}</span>
                </div>
                <div className="adv-readme-body" aria-hidden="true">
                  <p className="adv-readme-file">README.md</p>
                  <p className="adv-readme-title">
                    <Logo size={26} /> gitmanual
                  </p>
                  <p className="adv-readme-line">Setup manuals for open source. In any GitHub link, swap hub for manual.</p>
                  <div className="adv-readme-sponsor">
                    <small>Sponsored by</small>
                    <span>Your logo</span>
                  </div>
                  <i className="adv-readme-text" />
                  <i className="adv-readme-text adv-short" />
                </div>
              </figure>
            }
          >
            Your logo and link at the top of our README, seen by everyone who finds the project on GitHub, for the whole month.
          </Placement>
        </ul>

      </section>

      <section className="adv-section" id="packages" aria-labelledby="adv-packages">
        <p className="eyebrow">Packages</p>
        <h2 id="adv-packages">Two ways to run, 30 days each</h2>
        <div className="adv-plans">
          <div className="adv-plan">
            <h3>Shared</h3>
            <p className="adv-price">
              {usd(AD_PRICES.shared)} <small>for 30 days</small>
            </p>
            <ul>
              <li>Your ad on manual pages, the shelf, lists and developer pages, taking turns with one other ad</li>
              {social && <li>One poster on {page}</li>}
            </ul>
          </div>
          <div className="adv-plan adv-plan-top">
            <span className="adv-plan-tag">Most reach</span>
            <h3>Exclusive</h3>
            <p className="adv-price">
              {usd(AD_PRICES.exclusive)} <small>for 30 days</small>
            </p>
            <ul>
              <li>The only ad on manual pages, the shelf, lists and developer pages</li>
              <li>Your logo on gitmanual&apos;s README on GitHub</li>
              {social && <li>Two posters on {page}</li>}
              {social && <li>One Reel on {page}</li>}
            </ul>
          </div>
        </div>
        <p className="adv-terms">One payment before launch. Nothing renews by itself: a later month is booked and priced on its own.</p>
      </section>

      <section className="adv-section adv-fit" aria-labelledby="adv-fit">
        <div>
          <p className="eyebrow">Who it suits</p>
          <h2 id="adv-fit">Products developers use</h2>
          <ul>
            <li>Developer tools and AI coding tools</li>
            <li>Hosting, cloud and databases</li>
            <li>Monitoring, security and code review</li>
            <li>Courses and books for developers</li>
          </ul>
        </div>
        <div>
          <p className="eyebrow">How we run ads</p>
          <h2>Plain and labeled</h2>
          <ul>
            <li>Every ad is marked as an ad</li>
            <li>An image and a link: no tracking pixels, no popups</li>
            <li>Never on private repos&apos; manuals</li>
            <li>One ad per page</li>
          </ul>
        </div>
      </section>

      <section className="adv-section" aria-labelledby="adv-how">
        <p className="eyebrow">Booking</p>
        <h2 id="adv-how">How it works</h2>
        <ol className="adv-steps">
          <li>
            <b>Tell us</b> what you&apos;d like to advertise and which month, with the form below.
          </li>
          <li>
            <b>Agree the details</b> by email: the dates, the ad{social ? " and the posts" : ""}.
          </li>
          <li>
            <b>Pay once</b>, before launch.
          </li>
          <li>
            <b>It runs</b> for 30 days, then stops.
          </li>
        </ol>
      </section>

      <div className="adv-bottom">
        <section className="adv-faq" aria-labelledby="adv-faq">
          <h2 id="adv-faq">Questions</h2>
          <dl>
            <dt>What do I send?</dt>
            <dd>
              For the website: your logo or an image, one line of text and your link.
              {social ? " For the posts: a square image or a video, or tell us what to say and we'll make them in the page's style." : ""}
            </dd>
            <dt>How do I see results?</dt>
            <dd>Send a link with your own UTM tags: visits from gitmanual show up in your analytics.</dd>
            <dt>Does everyone see the website ad?</dt>
            <dd>Yes, everyone who visits.</dd>
            <dt>What don&apos;t you take?</dt>
            <dd>Gambling, crypto trading, adult content, and anything that asks people for their passwords or keys.</dd>
          </dl>
        </section>

        <section id="book" aria-labelledby="adv-book">
          <p className="eyebrow">Book a spot</p>
          <h2 id="adv-book">Tell us about your product</h2>
          <p className="adv-book-lead">We&apos;ll reply by email with the open months and next steps.</p>
          <div className="doc-form">
            <ProblemForm mode="contact" kind="advertising" only />
          </div>
        </section>
      </div>
    </article>
  );
}
