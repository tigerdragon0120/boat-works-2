import React, { useEffect, useState } from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import { Waves, Home, BarChart3, Settings, Search, Ticket, CalendarDays, Newspaper, Video, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { resumeKBatchImport, subscribeKBatchImport, getKBatchImportState } from "@/lib/kBatchImportManager";
import { resumeRacerTermImport, subscribeRacerTermImport, getRacerTermImportState } from "@/lib/racerTermImportManager";
import { base44 } from "@/api/base44Client";

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
  const [kImport, setKImport] = useState(getKBatchImportState());
  const [termImport, setTermImport] = useState(getRacerTermImportState());

  useEffect(() => {
    resumeKBatchImport();
    resumeRacerTermImport();
    const unsubK = subscribeKBatchImport(setKImport);
    const unsubTerm = subscribeRacerTermImport(setTermImport);

    // 期別成績の表示はlocalStorage任せにせず、サーバーの最新ジョブを定期確認する。
    // ページ遷移や再読込があっても、実際に処理中なら必ず全画面バナーを復元する。
    let cancelled = false;
    const refreshTermBannerFromServer = async () => {
      try {
        const jobs = await base44.entities.RacerTermImportJob.filter({}, "-created_date", 1);
        if (cancelled) return;
        const job = jobs?.[0];
        const active = job && ["queued", "preparing", "running"].includes(job.status);
        if (!active) {
          setTermImport((prev) => ({ ...prev, running: false, uploading: false }));
          return;
        }

        let item = null;
        if (job.batch_id) {
          const items = await base44.entities.RacerTermImportItem.filter({ batch_id: job.batch_id }, "order_index", 500);
          if (cancelled) return;
          item = (items || []).find((x) => ["processing", "queued", "awaiting_upload"].includes(x.status)) || items?.[0] || null;
        }

        setTermImport((prev) => ({
          ...prev,
          running: true,
          uploading: job.status === "preparing" || item?.status === "awaiting_upload",
          batchId: job.batch_id || "",
          current: Number(job.current_index || 0),
          total: Number(job.total_files || 0),
          file: job.current_file || item?.file_name || "",
          recordCurrent: Number(item?.offset || 0),
          recordTotal: Number(item?.total_records || 0),
        }));
      } catch {
        // 一時的に取得できなくても既存表示は消さない。
      }
    };

    refreshTermBannerFromServer();
    const timer = setInterval(refreshTermBannerFromServer, 2500);

    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubK?.();
      unsubTerm?.();
    };
  }, []);
  return (
    <div className="min-h-screen bg-[#eef2f7] text-[#26364d]">
      <header className="sticky top-0 z-30 bg-gradient-to-r from-[#153aa8] to-[#075ee8] border-b border-blue-700 shadow-sm">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-5 h-14 sm:h-16 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2.5 min-w-0 shrink-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white/10 border border-white/60 flex items-center justify-center shrink-0">
              <Waves className="w-5 h-5 text-white" strokeWidth={2.4} />
            </div>
            <div className="leading-none">
              <div className="font-display font-black tracking-tight text-white text-[15px] sm:text-[17px] whitespace-nowrap">BOAT WORKS 2</div>
              <div className="hidden sm:block text-[9px] text-blue-100 font-semibold tracking-widest mt-0.5 whitespace-nowrap">データで勝つ、ボートレース</div>
            </div>
          </Link>

          {/* BOATCAST風 横並びナビ (PC) */}
          <nav className="hidden lg:flex items-center gap-1">
            {subNav.map((n) => {
              const Icon = n.icon;
              return (
                <span key={n.label} className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-[13px] font-medium text-blue-50 hover:text-white hover:bg-white/10 cursor-default transition-colors">
                  <Icon className="w-3.5 h-3.5" />
                  {n.label}
                </span>
              );
            })}
          </nav>

          <div className="flex items-center gap-1.5 shrink-0">
            <button className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg text-white hover:bg-white/10 flex items-center justify-center transition-colors">
              <Search className="w-4.5 h-4.5" />
            </button>
            <nav className="flex items-center gap-1">
              {nav.map((n) => {
                const active = loc.pathname === n.to || (n.to === "/" && loc.pathname.startsWith("/venue")) || (n.to === "/race" && loc.pathname.startsWith("/race"));
                const Icon = n.icon;
                return (
                  <Link key={n.to} to={n.to} className={cn(
                    "flex items-center gap-1.5 px-2.5 sm:px-3 h-9 sm:h-10 rounded-lg text-sm font-semibold transition-colors",
                    active ? "bg-white text-[#075ee8]" : "text-white hover:bg-white/10"
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
      {(kImport?.running || kImport?.uploading || termImport?.running || termImport?.uploading) && (
        <div className="sticky top-14 sm:top-16 z-20 border-b border-emerald-700/40 bg-emerald-950/95 backdrop-blur px-3 py-2 text-emerald-100 shadow-sm">
          <div className="max-w-[1400px] mx-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:text-sm font-semibold">
            {kImport?.running && (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                K結果をバックグラウンド取込中 {kImport.current || 0}/{kImport.total || 0}{kImport.file ? ` — ${kImport.file}` : ""}
              </span>
            )}
            {termImport?.running && (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                {termImport.uploading
                  ? `選手期別成績を準備・取込中 ${termImport.uploadCurrent || 0}/${termImport.uploadTotal || termImport.total || 0}${termImport.file ? ` — ${termImport.file}` : ""}`
                  : `選手期別成績をバックグラウンド取込中 ${termImport.current || 0}/${termImport.total || 0}${termImport.file ? ` — ${termImport.file}` : ""}${termImport.recordTotal ? ` — ${termImport.recordCurrent || 0}/${termImport.recordTotal}件` : ""}`}
              </span>
            )}
          </div>
        </div>
      )}
      <main className="max-w-[1400px] mx-auto px-2.5 sm:px-4 py-3 sm:py-5 pb-24 sm:pb-12"><Outlet /></main>
      <footer className="fixed bottom-0 inset-x-0 z-40 sm:hidden bg-white/95 backdrop-blur border-t border-[#d9e1ec] shadow-[0_-4px_14px_rgba(15,23,42,0.06)] flex pb-[env(safe-area-inset-bottom)]">
        {nav.map((n) => {
          const active = loc.pathname === n.to || (n.to === "/" && loc.pathname.startsWith("/venue"));
          const Icon = n.icon;
          return <Link key={n.to} to={n.to} className={cn("flex-1 min-h-14 flex flex-col items-center justify-center py-2.5 text-[11px] font-medium", active ? "text-[#075ee8]" : "text-slate-500")}><Icon className="w-5 h-5 mb-0.5" />{n.label}</Link>;
        })}
      </footer>
    </div>
  );
}