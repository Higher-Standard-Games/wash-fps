import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "Washiki Washoi",
    description: "Arena FPS built on the SHAG Engine — Q3/Warsow-style movement, server-authoritative combat",

    srcDir: ".",
    // Keep unreleased mode notes in source, outside the published site and search.
    srcExclude: ["gametypes/team-deathmatch.md"],
    outDir: "../../dist-docs",
    appearance: "dark",
    mermaid: {
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        fontFamily: '"Manual Inter", sans-serif',
        primaryColor: "#ffcc33",
        primaryTextColor: "#130e1c",
        primaryBorderColor: "#9e43e6",
        secondaryColor: "#211b32",
        secondaryTextColor: "#fff8e6",
        lineColor: "#9e43e6",
      },
      flowchart: { htmlLabels: false },
    },

    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Player Manual", link: "/player/" },
        { text: "Gametypes", link: "/gametypes/" },
        { text: "Multiplayer", link: "/multiplayer/" },
        { text: "Developer", link: "/developer/" },
      ],

      sidebar: {
        "/": [
          {
            text: "Introduction",
            items: [
              { text: "What is Washiki Washoi?", link: "/introduction/" },
              { text: "Glossary", link: "/introduction/glossary" },
            ],
          },
          {
            text: "Getting Started",
            items: [
              { text: "Setup & First Run", link: "/getting-started/" },
              { text: "Project Structure", link: "/getting-started/project-structure" },
              { text: "Troubleshooting Setup", link: "/getting-started/troubleshooting" },
            ],
          },
          {
            text: "Player Manual",
            collapsed: false,
            items: [
              { text: "Overview", link: "/player/" },
              { text: "Your First Match", link: "/player/first-match" },
              { text: "Movement", link: "/player/movement" },
              { text: "Weapons", link: "/player/weapons" },
              { text: "Damage & Combat", link: "/player/combat" },
              { text: "Pickups & Inventory", link: "/player/pickups-and-inventory" },
              { text: "HUD", link: "/player/hud" },
              { text: "Match Flow & Screens", link: "/player/screens" },
              { text: "Settings", link: "/player/settings" },
            ],
          },
          {
            text: "Gametypes",
            collapsed: false,
            items: [
              { text: "Overview", link: "/gametypes/" },
              { text: "Duel", link: "/gametypes/duel" },
              { text: "Amphi", link: "/gametypes/amphi" },
              { text: "Deathmatch", link: "/gametypes/deathmatch" },
              { text: "Search & Destroy", link: "/gametypes/search-and-destroy" },
              { text: "Maps", link: "/gametypes/maps" },
            ],
          },
          {
            text: "Multiplayer",
            collapsed: false,
            items: [
              { text: "Overview", link: "/multiplayer/" },
              { text: "Lobby, Rooms & Accounts", link: "/multiplayer/lobby" },
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
              { text: "Bot Training", link: "/tools/bot-training" },
              { text: "Demo Cinematic", link: "/tools/demo-cinematic" },
            ],
          },
          {
            text: "FAQ",
            link: "/faq/",
          },
        ],
      },

      socialLinks: [{ icon: "github", link: "https://github.com/Higher-Standard-Games/shag" }],

      search: {
        provider: "local",
      },

      footer: {
        message: "Built on the SHAG Engine.",
        copyright: "Copyright © 2024–present",
      },
    },
  }),
);
