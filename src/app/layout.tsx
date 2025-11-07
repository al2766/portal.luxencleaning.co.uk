// src/app/layout.tsx
import './globals.css';
import StaffHeader from './components/StaffHeader';

export const metadata = {
  title: 'Luxen Staff Portal',
  description: 'Portal for Luxen Cleaning staff to manage jobs and profiles',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full bg-gray-50">
      <body className="min-h-screen flex flex-col text-gray-900 antialiased">
        {/* Header (client component handles auth + admin-only link) */}
        <StaffHeader />

        {/* Main content */}
        <main className="flex-grow max-w-6xl mx-auto w-full px-4 py-6">
          {children}
        </main>

        {/* Footer */}
        <footer className="bg-gray-100 border-t py-3 text-center text-sm text-gray-500">
          © {new Date().getFullYear()} Luxen Cleaning
        </footer>
      </body>
    </html>
  );
}
