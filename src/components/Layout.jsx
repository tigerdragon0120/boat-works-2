import React from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import { Waves, Home, BarChart3, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "ホーム", icon: Home },
  { to: "/verify", label: "検証", icon: BarChart3 },
  { to: "/admin", label: "管理", icon: Settings },
];

export default function Layout() {
  const loc = useLocation();
  return (
    <div className="min-h-screen bg-[#05090d] text-slate-100">
      <header className="sticky top-0 z-30 bg-[#070b10]/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/15 border border-blue-500/30 flex items-center justify-center">
              <Waves className="w-5 h-5 text-blue-400" strokeWidth={2.4} />
            </div>
            <div className="leading-none">
              <div className="font-display font-bold tracking-tight text-white text-[16px]">BOAT WORKS 2</div>
              <div className="text-[10px] text-blue-400 font-semibold tracking-widest mt-1">AI RACE PREDICTION</div>
            </div>
          </Link>
          <nav className="flex items-center gap-1">
            {nav.map((n) => {
              const active = loc.pathname === n.to;
              const Icon = n.icon;
              return (
                <Link key={n.to} to={n.to} className={cn(
                  "flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-medium transition-colors",
                  active ? "bg-blue-600 text-white shadow-sm" : "text-slate-400 hover:bg-slate-900 hover:text-white"
                )}>
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{n.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-5 pb-24"><Outlet /></main>
      <footer className="fixed bottom-0 inset-x-0 sm:hidden bg-[#070b10] border-t border-slate-800 flex">
        {nav.map((n) => {
          const active = loc.pathname === n.to;
          const Icon = n.icon;
          return <Link key={n.to} to={n.to} className={cn("flex-1 flex flex-col items-center justify-center py-2.5 text-[11px] font-medium", active ? "text-blue-400" : "text-slate-500")}><Icon className="w-5 h-5 mb-0.5" />{n.label}</Link>;
        })}
      </footer>
    </div>
  );
}
