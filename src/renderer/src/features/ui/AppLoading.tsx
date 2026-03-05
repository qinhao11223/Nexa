import React from 'react'

export default function AppLoading() {
  return (
    <div className="nx-app-loading" role="status" aria-live="polite">
      <div className="nx-app-loading-card">
        <div className="nx-app-loading-logo">NEXA</div>
        <div className="nx-app-loading-sub">正在加载…</div>
        <div className="nx-app-loading-bar" aria-hidden="true">
          <div className="fill" />
        </div>
      </div>
    </div>
  )
}
