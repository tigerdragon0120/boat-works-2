import React from 'react';
import { Outlet, Navigate, Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';

const Fallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

// 管理者専用ルート。未ログインはログイン画面へ、一般ユーザーは明示的に拒否する。
export default function AdminRoute() {
  const { user, isAuthenticated, isLoadingAuth, isLoadingPublicSettings, authChecked, authError } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth || !authChecked) return <Fallback />;

  if (!isAuthenticated || authError) return <Navigate to="/login" replace />;

  if (user?.role !== 'admin') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-rose-200 bg-white p-6 text-center space-y-3">
          <ShieldAlert className="w-8 h-8 text-rose-600 mx-auto" />
          <h1 className="text-lg font-black text-slate-900">管理者専用ページです</h1>
          <p className="text-sm text-slate-600">このアカウントには管理権限がありません。URLから直接開いた場合も表示されません。</p>
          <Link to="/" className="inline-flex px-4 h-10 items-center rounded-lg bg-slate-900 text-white text-sm font-bold">レース一覧へ戻る</Link>
        </div>
      </div>
    );
  }

  return <Outlet />;
}