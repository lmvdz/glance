import React from 'react';
import { useTaskContext } from '../context/TaskContext';
import { CheckCircle2, Info, AlertCircle, X } from 'lucide-react';

export const ToastContainer = () => {
  const { toasts } = useTaskContext();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(toast => (
        <div 
          key={toast.id} 
          className="flex items-center gap-3 bg-gray-900 text-white px-4 py-3 rounded-lg shadow-lg text-sm min-w-[300px] animate-in slide-in-from-bottom-5 fade-in duration-300"
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-red-400" />}
          {toast.type === 'info' && <Info className="w-5 h-5 text-blue-400" />}
          
          <span className="flex-1 font-medium">{toast.message}</span>
        </div>
      ))}
    </div>
  );
};
