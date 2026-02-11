"use client";

export function PayNowButton({
  paymentUrl,
  amount,
}: {
  paymentUrl: string;
  amount: string;
}) {
  return (
    <a
      href={paymentUrl}
      className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
    >
      Pay {amount} Now
    </a>
  );
}
