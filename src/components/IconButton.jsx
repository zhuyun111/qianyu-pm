import { useState } from 'react'

function IconButton({ children, icon, text, iconPosition = 'left', className = '', tooltip = '', ...props }) {
  const hasIcon = icon !== undefined
  const hasText = text !== undefined
  const [showTooltip, setShowTooltip] = useState(false)

  const renderContent = () => {
    if (!hasIcon && !hasText) {
      return children
    }

    if (hasIcon && !hasText) {
      return <span className="icon-btn-icon">{icon}</span>
    }

    if (!hasIcon && hasText) {
      return <span className="icon-btn-text">{text}</span>
    }

    if (iconPosition === 'right') {
      return (
        <>
          <span className="icon-btn-text">{text}</span>
          <span className="icon-btn-icon">{icon}</span>
        </>
      )
    }

    return (
      <>
        <span className="icon-btn-icon">{icon}</span>
        <span className="icon-btn-text">{text}</span>
      </>
    )
  }

  return (
    <span className={`icon-btn-wrapper ${tooltip ? 'icon-btn-with-tooltip' : ''}`}>
      <button 
        className={`icon-btn ${className}`} 
        {...props}
        onMouseEnter={() => tooltip && setShowTooltip(true)}
        onMouseLeave={() => tooltip && setShowTooltip(false)}
      >
        {renderContent()}
      </button>
      {tooltip && (
        <span className={`icon-btn-tooltip ${showTooltip ? 'visible' : ''}`}>
          {tooltip}
        </span>
      )}
    </span>
  )
}

export default IconButton