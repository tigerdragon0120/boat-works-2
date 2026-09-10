import React, { useState } from "react";
import { Database, FileSpreadsheet, CloudDownload, BarChart3, Code, Users, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import DataDashboard from "@/components/admin/DataDashboard";
import FileImportSection from "@/components/admin/FileImportSection";
import OnlineFetchSection from "@/components/admin/OnlineFetchSection";
import DeveloperTools from "@/components/admin/DeveloperTools";
import RacerDataSection from "@/components/admin/RacerDataSection";
import AutoUpdateSection from "@/components/admin/AutoUpdateSection";

const tabs = [
  { k: "auto", l: "自動更新", icon: RefreshCw },
  { k: "file", l: "公式ファイル取込", icon: FileSpreadsheet },
  { k: "racer", l: "選手データ", icon: Users },
  { k: "online", l: "オンライン取得", icon: CloudDownload },
  { k: "status", l: "今日の状態", icon: BarChart3 },
  { k: "dev", l: "開発者向け", icon: Code },
];

export default function Admin() {
  const [tab, setTab] = useState("auto");

  return (
    <div>
      {/* ヘッダー */}
      <div className="flex items-center gap-2 mb-4">
        <Database className="w-5 h-5 text-sky-600" />
        <h1 className="text-xl font-display font-bold text-slate-900">BOAT WORKS 2 データ管理</h1>
      </div>

      {/* 今日の状態ダッシュボード(常に上部表示) */}
      {tab !== "status" && (
        <div className="mb-4">
          <DataDashboard />
        </div>
      )}

      {/* タブナビ */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={cn(
              "px-3 h-9 rounded-lg text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors",
              tab === t.k ? "bg-sky-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            )}>
            <t.icon className="w-4 h-4" /> {t.l}
          </button>
        ))}
      </div>

      {/* タブ内容 */}
      {tab === "auto" && <AutoUpdateSection />}
      {tab === "file" && <FileImportSection />}
      {tab === "racer" && <RacerDataSection />}
      {tab === "online" && <OnlineFetchSection />}
      {tab === "status" && <DataDashboard />}
      {tab === "dev" && <DeveloperTools />}
    </div>
  );
}