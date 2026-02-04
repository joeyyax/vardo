import { TooltipProvider } from "@/components/ui/tooltip"
import { Sidebar, MobileSidebar, EntryBar } from "@/components/layout"

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <div className="flex h-dvh bg-background">
        {/* Desktop Sidebar */}
        <div className="hidden lg:block">
          <Sidebar />
        </div>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top Bar with Entry Bar */}
          <header className="flex h-auto min-h-14 items-center gap-3 border-b bg-background px-4 py-3">
            <MobileSidebar />
            <div className="flex-1">
              <EntryBar />
            </div>
          </header>

          {/* Page Content */}
          <main className="flex-1 overflow-y-auto p-4 lg:p-6">
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
