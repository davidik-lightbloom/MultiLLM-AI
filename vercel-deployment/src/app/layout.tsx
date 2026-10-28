import { Inter } from "next/font/google";
import "./globals.css";
import { ReactQueryProvider } from "@/components/providers/react-query-provider";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { Toaster } from "react-hot-toast";
import Header from "@/components/layout/header";
import Footer from "@/components/layout/footer";
import StagingBanner from "@/components/layout/staging-banner";
import BetaBanner from "@/components/layout/beta-banner";

const inter = Inter({ subsets: ["latin"] });

const BASE_URL = "https://multillm-three.vercel.app";
const DESCRIPTION = "One prompt. Multiple LLMs. The best answer, automatically selected.";

export const metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "MultiLLM - Ensemble AI Platform",
    template: "%s — MultiLLM",
  },
  description: DESCRIPTION,
  openGraph: {
    title: "MultiLLM - Ensemble AI Platform",
    description: DESCRIPTION,
    url: BASE_URL,
    siteName: "MultiLLM",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "MultiLLM - Ensemble AI Platform",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <ReactQueryProvider>
            <StagingBanner />
            <BetaBanner />
            <Header />
            <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
              {children}
            </main>
            <Footer />
          </ReactQueryProvider>
          <Toaster position="top-right" />
        </AuthProvider>
      </body>
    </html>
  );
}
