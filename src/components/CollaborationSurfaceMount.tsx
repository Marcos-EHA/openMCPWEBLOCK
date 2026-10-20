import React, { useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import { CollaborationSurface } from './CollaborationSurface.js'
import { getSentinelCurator } from '../services/collaboration/SentinelCurator.js'
import { isLienzoEnabled } from '../services/collaboration/lienzoToggle.js'

export function CollaborationSurfaceMount(): React.ReactNode {
  const [visible, setVisible] = useState(isLienzoEnabled())
  const [content, setContent] = useState(() => getSentinelCurator().getContent())

  useEffect(() => {
    const interval = setInterval(() => setVisible(isLienzoEnabled()), 1000)
    const unsub = getSentinelCurator().subscribe(c => setContent({ ...c }))
    return () => { clearInterval(interval); unsub() }
  }, [])

  if (!visible) return null
  return <CollaborationSurface />
}

export default CollaborationSurfaceMount