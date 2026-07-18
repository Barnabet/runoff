import type { Metadata } from "next";
import { Newsreader, Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Toast } from "@/components/Toast";

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
});
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plexmono",
});

export const metadata: Metadata = {
  title: "Runoff",
  description: "Runoff — recurring analytical documents from source packs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${archivo.variable} ${plexMono.variable}`}
    >
      <body className="font-serif antialiased">
        {children}
        <Toast />
      </body>
    </html>
  );
}
