'use client';

import React from 'react';
import { X } from 'lucide-react';

interface PollingStats {
  isActive: boolean;
  lastPollTime: string | null;
  lastSuccessTime: string | null;
  lastErrorTime: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  successRate: number;
}

interface PollingStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemName: string;
  stats: PollingStats;
}

export default function PollingStatsModal({ isOpen, onClose, systemName, stats }: PollingStatsModalProps) {
  if (!isOpen) return null;

  const formatDateTime = (dateTimeStr: string | null) => {
    if (!dateTimeStr) return null;
    const date = new Date(dateTimeStr);
    // Use the browser's default locale (undefined) which automatically uses the user's system locale
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800/95 backdrop-blur border border-gray-700 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto">
        <div className="sticky top-0 bg-gray-800/95 backdrop-blur border-b border-gray-700 p-4 flex justify-between items-center">
          <h2 className="text-xl font-semibold text-white">
            Polling Statistics — {systemName}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
            aria-label="Close modal"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <div className="p-4">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <tbody className="divide-y divide-gray-700">
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Status</td>
                  <td className="py-3 px-4 text-white">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      stats.isActive 
                        ? 'bg-green-900/50 text-green-400 border border-green-700'
                        : 'bg-gray-700 text-gray-400 border border-gray-600'
                    }`}>
                      {stats.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Last Poll</td>
                  <td className="py-3 px-4 text-white">
                    {formatDateTime(stats.lastPollTime) || 'Never'}
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Last Success</td>
                  <td className="py-3 px-4 text-white">
                    {formatDateTime(stats.lastSuccessTime) || 'Never'}
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Last Error</td>
                  <td className="py-3 px-4 text-white">
                    {stats.lastErrorTime ? (
                      <div>
                        <div>{formatDateTime(stats.lastErrorTime)}</div>
                        {stats.lastError && (
                          <div className="text-sm text-red-400 mt-1">{stats.lastError}</div>
                        )}
                      </div>
                    ) : (
                      'No errors'
                    )}
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Consecutive Errors</td>
                  <td className="py-3 px-4 text-white">
                    <span className={stats.consecutiveErrors > 0 ? 'text-yellow-400' : ''}>
                      {stats.consecutiveErrors}
                    </span>
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Total Polls</td>
                  <td className="py-3 px-4 text-white">{stats.totalPolls.toLocaleString()}</td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Successful</td>
                  <td className="py-3 px-4 text-white">
                    <span className="text-green-400">{stats.successfulPolls.toLocaleString()}</span>
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Failed</td>
                  <td className="py-3 px-4 text-white">
                    <span className={stats.failedPolls > 0 ? 'text-red-400' : ''}>
                      {stats.failedPolls.toLocaleString()}
                    </span>
                  </td>
                </tr>
                
                <tr>
                  <td className="py-3 px-4 text-gray-400 font-medium">Success Rate</td>
                  <td className="py-3 px-4 text-white">
                    <div className="flex items-center gap-3">
                      <span className={`font-semibold ${
                        stats.successRate >= 95 ? 'text-green-400' :
                        stats.successRate >= 80 ? 'text-yellow-400' :
                        'text-red-400'
                      }`}>
                        {stats.successRate.toFixed(1)}%
                      </span>
                      <div className="flex-1 max-w-xs">
                        <div className="w-full bg-gray-700 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              stats.successRate >= 95 ? 'bg-green-500' :
                              stats.successRate >= 80 ? 'bg-yellow-500' :
                              'bg-red-500'
                            }`}
                            style={{ width: `${stats.successRate}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}