const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const PREFIX = "!";

// Connexion à PostgreSQL via Railway
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialisation de la table revenus
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS revenus (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50),
            amount NUMERIC(10,2),
            category VARCHAR(50),
            description TEXT,
            date TIMESTAMP DEFAULT NOW()
        )
    `);
}
initDB();

// Gestion des montants décimaux
function parseAmount(input) {
    if (!input) return NaN;
    return parseFloat(input.replace(",", "."));
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const userId = message.author.id;

    // ➕ ADD
    if (command === "add") {
        const amount = parseAmount(args[0]);
        const category = args[1] || "autre";
        const description = args.slice(2).join(" ") || "Sans description";

        if (isNaN(amount)) return message.reply("❌ Montant invalide");

        await pool.query(
            `INSERT INTO revenus (user_id, amount, category, description) VALUES ($1,$2,$3,$4)`,
            [userId, amount, category, description]
        );

        return message.reply(`✅ Ajouté : ${amount.toFixed(2)}€ (${category})`);
    }

    // 💰 TOTAL
    if (command === "total") {
        const category = args[0];
        let query = `SELECT SUM(amount) as total FROM revenus WHERE user_id=$1`;
        let params = [userId];

        if (category) {
            query += ` AND category=$2`;
            params.push(category);
        }

        const res = await pool.query(query, params);
        const total = res.rows[0].total || 0;
        return message.reply(`💰 Ton total ${category || "global"} : ${total.toFixed(2)}€`);
    }

    // 📅 MONTH
    if (command === "month") {
        const now = new Date();
        const res = await pool.query(`SELECT amount, date FROM revenus WHERE user_id=$1`, [userId]);

        const filtered = res.rows.filter(r => {
            const d = new Date(r.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const total = filtered.reduce((sum, r) => sum + parseFloat(r.amount), 0);
        return message.reply(`📅 Ton total ce mois : ${total.toFixed(2)}€`);
    }

    // 📜 LISTE AVEC BOUTONS
    if (command === "list") {
        const res = await pool.query(`SELECT * FROM revenus WHERE user_id=$1 ORDER BY id`, [userId]);
        const userRevenus = res.rows;

        if (userRevenus.length === 0) return message.reply("📭 Aucun revenu");

        const embed = new EmbedBuilder().setTitle("📜 Tes revenus").setColor(0x00AEFF);
        const rows = [];

        userRevenus.forEach(r => {
            embed.addFields({ name: `ID ${r.id}`, value: `${r.amount.toFixed(2)}€ [${r.category}] - ${r.description}`, inline: false });

            const button = new ButtonBuilder()
                .setCustomId(`delete_${r.id}_${userId}`)
                .setLabel(`🗑️ Supprimer ID ${r.id}`)
                .setStyle(ButtonStyle.Danger);

            rows.push(new ActionRowBuilder().addComponents(button));
        });

        return message.channel.send({ embeds: [embed], components: rows });
    }

    // 🧹 RESET
    if (command === "reset") {
        await pool.query(`DELETE FROM revenus WHERE user_id=$1`, [userId]);
        return message.reply("🗑️ Tous TES revenus ont été supprimés");
    }

    // ❓ HELP
    if (command === "help") {
        const embed = new EmbedBuilder()
            .setTitle("📊 Bot gestion de revenus")
            .setColor(0x00AEFF)
            .setDescription(`
➕ !add montant catégorie description
📜 !list
💰 !total [catégorie]
📅 !month
🧹 !reset
❓ !help
            `);

        return message.channel.send({ embeds: [embed] });
    }
});

// 🔘 GESTION DES BOUTONS SUPPRESSION
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("delete_")) return;

    const parts = interaction.customId.split("_");
    const id = parseInt(parts[1]);
    const userId = parts[2];

    if (interaction.user.id !== userId) {
        return interaction.reply({ content: "❌ Tu ne peux pas supprimer les revenus d'un autre utilisateur", ephemeral: true });
    }

    const res = await pool.query(`DELETE FROM revenus WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId]);
    if (res.rowCount === 0) {
        return interaction.reply({ content: "❌ Revenu introuvable", ephemeral: true });
    }

    return interaction.reply({ content: `🗑️ Supprimé : ${res.rows[0].amount.toFixed(2)}€ (${res.rows[0].category})`, ephemeral: true });
});

client.login(process.env.DISCORD_TOKEN);
