import "./globals.css";
import "./dots-interface.css";
import "./liquid-glass.css";
import "./connectors.css";
import "./team.css";
import "./appearance.css";
import PwaProvider from "../components/PwaProvider";

export const metadata = {
  title: "Dots · Tu espacio para pensar y crear",
  description:
    "Tus agentes personales para conversar, recordar y avanzar con tus proyectos.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Dots", statusBarStyle: "black-translucent" },
  icons: { icon: "/app-icon.png", apple: { url: "/app-icon.png", sizes: "1254x1254", type: "image/png" } },
  openGraph: {
    title: "Dots · Tu espacio para pensar y crear",
    description:
      "Un espacio personal para tus ideas, conversaciones y agentes.",
    type: "website",
  },
};

export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0e1420" };

export default function RootLayout({ children }) {
  return (
    <html lang="es" className="dark" suppressHydrationWarning={true}>
      <body className="bg-background text-foreground antialiased">
        <PwaProvider>{children}</PwaProvider>
      </body>
    </html>
  );
}
