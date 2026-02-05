"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-lg bg-gray-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800"
    >
      Print Invoice
    </button>
  );
}
