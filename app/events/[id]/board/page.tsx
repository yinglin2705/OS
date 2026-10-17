import EventBoard from '@/components/EventBoard';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return <EventBoard eventId={id} />;
}
