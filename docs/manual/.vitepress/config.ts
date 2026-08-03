import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Washiki Washoi",
  description: "Arena FPS built on the SHAG Engine — Q3/Warsow-style movement, server-authoritative combat",

  srcDir: ".",
  outDir: "../../dist-docs",

  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap",
        rel: "stylesheet",
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Player Manual", link: "/player/" },
      { text: "Multiplayer", link: "/multiplayer/" },
      { text: "Developer", link: "/developer/" },
    ],

    sidebar: {
      "/": [
        {
          text: "Introduction",
          items: [
            { text: "What is Washiki Washoi?", link: "/introduction/" },
          ],
        },
        {
          text: "Getting Started",
          items: [
            { text: "Setup & First Run", link: "/getting-started/" },
            { text: "Project Structure", link: "/getting-started/project-structure" },
          ],
        },
        {
          text: "Player Manual",
          collapsed: false,
          items: [
            { text: "Overview", link: "/player/" },
            { text: "Movement", link: "/player/movement" },
            { text: "Weapons", link: "/player/weapons" },
            { text: "Pickups & Inventory", link: "/player/pickups-and-inventory" },
            { text: "HUD", link: "/player/hud" },
          ],
        },
        {
          text: "Gametypes",
          collapsed: false,
          items: [
            { text: "Overview", link: "/gametypes/" },
            { text: "Duel", link: "/gametypes/duel" },
            { text: "Deathmatch", link: "/gametypes/deathmatch" },
            { text: "Team Deathmatch", link: "/gametypes/team-deathmatch" },
            { text: "Search & Destroy", link: "/gametypes/search-and-destroy" },
          ],
        },
        {
          text: "Multiplayer",
          collapsed: false,
          items: [
            { text: "Overview", link: "/multiplayer/" },
            { text: "Connecting", link: "/multiplayer/connecting" },
            { text: "In-Game Chat", link: "/multiplayer/chat" },
            { text: "Demos", link: "/multiplayer/demos" },
          ],
        },
        {
          text: "Developer",
          collapsed: true,
          items: [
            { text: "Overview", link: "/developer/" },
            { text: "Adding a Weapon", link: "/developer/adding-a-weapon" },
            { text: "Adding a Gametype", link: "/developer/adding-a-gametype" },
            { text: "Server Commands", link: "/developer/server-commands" },
          ],
        },
        {
          text: "Tools",
          collapsed: true,
          items: [
            { text: "Overview", link: "/tools/" },
            { text: "Bot Intelligence Server", link: "/tools/bot-server" },
            { text: "Demo Cinematic", link: "/tools/demo-cinematic" },
          ],
        },
        {
          text: "FAQ",
          link: "/faq/",
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/Higher-Standard-Games/shag" },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message: "Built on the SHAG Engine.",
      copyright: "Copyright © 2024–present",
    },
  },
});
