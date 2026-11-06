/** Two-column frame for public auth pages: dark brand panel + light form surface. */
export function AuthFrame({ title, lede, children }: { title: string; lede?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="hidden flex-col justify-between bg-rail p-10 text-white lg:flex">
        <div className="flex items-center gap-2">
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-white text-sm font-semibold text-black">Q</span>
          <span className="text-sm font-medium tracking-tighter">QuikReach · QuikIT</span>
        </div>
        <div>
          <p className="max-w-sm text-[34px] leading-tight tracking-tighter">Know what your sending domains and mailboxes are actually telling you.</p>
          <ul className="mt-6 space-y-2 text-sm text-white/60">
            <li>DNS authentication checks with recorded evidence</li>
            <li>Mailbox signals from Google and Microsoft — via OAuth, never passwords</li>
            <li>Alerts and campaign-safety rules with honest outcomes</li>
          </ul>
        </div>
        <p className="text-xs text-white/40">QuikReach does not promise inbox placement. It shows observed signals, and labels estimates and hypotheses.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-medium tracking-tighter text-ink">{title}</h1>
          {lede ? <p className="mt-1.5 text-sm text-muted">{lede}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

export const inputCls = "mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-stone-400";
