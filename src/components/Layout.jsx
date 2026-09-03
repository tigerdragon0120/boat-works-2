import React from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import { Waves, Home, BarChart3, Settings, Search, Ticket, CalendarDays, Newspaper, Video, Database } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "レース一覧", icon: Home },
  { to: "/verify", label: "検証", icon: BarChart3 },
  { to: "/database", label: "DB", icon: Database },
  { to: "/admin", label: "管理", icon: Settings },
];

// BOATCAST風 補助ナビ(装飾用、実導線は上記nav)
const subNav = [
  { label: "投票", icon: Ticket },
  { label: "レースLIVE", icon: Waves },
  { label: "配信スケジュール", icon: CalendarDays },
  { label: "ニュース", icon: Newspaper },
  { label: "動画コンテンツ", icon: Video },
];

export default function Layout() {
  const loc = useLocation();
  return (
    <div className="min-h-screen bg-[#11161d] text-slate-100">
      <header className="sticky top-0 z-30 bg-[#161a22] border-b border-[#2d3748]">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-5 h-14 sm:h-16 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2.5 min-w-0 shrink-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-blue-600/15 border border-blue-500/30 flex items-center justify-center shrink-0">
              <Waves className="w-5 h-5 text-blue-400" strokeWidth={2.4} />
            </div>
            <div className="leading-none">
              <div className="font-display font-black tracking-tight text-white text-[15px] sm:text-[17px] whitespace-nowrap">BOAT WORKS 2</div>
              <div className="hidden sm:block text-[9px] text-blue-400/80 font-semibold tracking-widest mt-0.5 whitespace-nowrap">AI RACE PREDICTION</div>
            </div>
          </Link>

          {/* BOATCAST風 横並びナビ (PC) */}
          <nav className="hidden lg:flex items-center gap-1">
            {subNav.map((n) => {
              const Icon = n.icon;
              return (
                <span key={n.label} className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-[13px] font-medium text-slate-400 hover:text-white hover:bg-[#1e232d] cursor-default transition-colors">
                  <Icon className="w-3.5 h-3.5" />
                  {n.label}
                </span>
              );
            })}
          </nav>

          <div className="flex items-center gap-1.5 shrink-0">
            <button className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg text-slate-400 hover:text-white hover:bg-[#1e232d] flex items-center justify-center transition-colors">
              <Search className="w-4.5 h-4.5" />
            </button>
            <nav className="flex items-center gap-1">
              {nav.map((n) => {
                const active = loc.pathname === n.to || (n.to === "/" && loc.pathname.startsWith("/venue")) || (n.to === "/race" && loc.pathname.startsWith("/race"));
                const Icon = n.icon;
                return (
                  <Link key={n.to} to={n.to} className={cn(
                    "flex items-center gap-1.5 px-2.5 sm:px-3 h-9 sm:h-10 rounded-lg text-sm font-semibold transition-colors",
                    active ? "bg-[#f9c836] text-slate-950" : "text-slate-300 hover:bg-[#1e232d] hover:text-white"
                  )}>
                    <Icon className="w-4 h-4" />
                    <span className="hidden md:inline">{n.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-2.5 sm:px-4 py-3 sm:py-5 pb-24 sm:pb-12"><Outlet /></main>
      <footer className="fixed bottom-0 inset-x-0 z-40 sm:hidden bg-[#161a22]/98 backdrop-blur border-t border-[#2d3748] flex pb-[env(safe-area-inset-bottom)]">
        {nav.map((n) => {
          const active = loc.pathname === n.to || (n.to === "/" && loc.pathname.startsWith("/venue"));
          const Icon = n.icon;
          return <Link key={n.to} to={n.to} className={cn("flex-1 min-h-14 flex flex-col items-center justify-center py-2.5 text-[11px] font-medium", active ? "text-[#f9c836]" : "text-slate-500")}><Icon className="w-5 h-5 mb-0.5" />{n.label}</Link>;
        })}
      </footer>
    </div>
  );
}