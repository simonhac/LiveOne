'use client'

interface PeriodSwitcherProps {
  value: '1D' | '7D' | '30D'
  onChange: (value: '1D' | '7D' | '30D') => void
  className?: string
}

export default function PeriodSwitcher({ value, onChange, className = '' }: PeriodSwitcherProps) {
  const periods: Array<'1D' | '7D' | '30D'> = ['1D', '7D', '30D']
  
  return (
    <div className={`inline-flex rounded-md shadow-sm ${className}`} role="group">
      {periods.map((period, index) => (
        <button
          key={period}
          onClick={() => onChange(period)}
          className={`
            px-3 py-1 text-xs font-medium transition-colors border
            ${index === 0 ? 'rounded-l-md' : '-ml-px'}
            ${index === periods.length - 1 ? 'rounded-r-md' : ''}
            ${value === period 
              ? 'bg-blue-900/50 text-blue-300 border-blue-800 z-10' 
              : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
            }
          `}
        >
          {period}
        </button>
      ))}
    </div>
  )
}