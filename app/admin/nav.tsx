// The admin pages' own menu, on every page under /admin. Only links: each page's API checks who's signed in.
const PAGES = [
  { id: "home", href: "/admin", label: "Home" },
  { id: "problems", href: "/admin/problems", label: "Inbox" },
  { id: "purchases", href: "/admin/purchases", label: "Purchases" },
  { id: "users", href: "/admin/users", label: "Users" },
  { id: "email", href: "/admin/email", label: "Email" },
  { id: "chat", href: "/admin/chat", label: "Chat" },
  { id: "keys", href: "/admin/keys", label: "API keys" },
  { id: "health", href: "/admin/health", label: "Health" },
] as const;

export type AdminPage = (typeof PAGES)[number]["id"] | "user";

export function AdminNav({ current }: { current: AdminPage }) {
  return (
    <nav className="admin-nav" aria-label="Admin">
      {PAGES.map((p) => (
        <a key={p.id} href={p.href} aria-current={p.id === current ? "page" : undefined}>
          {p.label}
        </a>
      ))}
    </nav>
  );
}
