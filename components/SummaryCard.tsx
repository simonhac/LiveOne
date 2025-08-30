import { LucideIcon } from 'lucide-react'

interface SummaryCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  iconColor: string
}

export default function SummaryCard({ label, value, icon: Icon, iconColor }: SummaryCardProps) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded p-3 flex items-center justify-between min-w-0 flex-1">
      <div className="min-w-0 flex-1">
        <p className="text-gray-400 text-xs truncate">{label}</p>
        <p className="text-lg font-bold text-white truncate">{value}</p>
      </div>
      <Icon className={`w-5 h-5 ${iconColor} flex-shrink-0 ml-2`} />
    </div>
  )
}