import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.signupSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, mode: "invite_code" },
  });
  console.log("Seeded signup_setting (mode=invite_code).");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
