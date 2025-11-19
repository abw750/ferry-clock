// public/ferryState.js

// plan:

// Owns pollOnce, shape, updateDockState, buildCanonicalState, dockState, syntheticArrivals.

// Exposes:

// async pollOnce() to refresh internal cache

// getCanonicalState() to feed /api/state

// getSummary() / getRaw() to feed legacy endpoints