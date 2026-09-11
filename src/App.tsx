import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import { lazy, Suspense } from 'react'
const ArtReview = lazy(() => import('./pages/ArtReview'))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/art-review" element={<Suspense fallback={<div>加载美术资产…</div>}><ArtReview /></Suspense>} />
    </Routes>
  )
}
