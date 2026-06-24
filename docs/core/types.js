// Core data model. Shared by every interface (CLI, web, future Pi/Arduino).
// Times are integer epoch milliseconds. Durations are integer milliseconds.
// We never store floats — drift-free and exact. ponytail: ints over floats, no rounding bugs.

/** Max timers a single card may hold. Keeps scope from exploding. */
export const MAX_TIMERS = 10;

/** A thing the user wants to dedicate time to: a hobby, a category, a task.
 *  e.g. "Writing", "Cooking", "Studying". NOT a specific session — the bucket.
 *  A card OWNS a list of Timers (≤ MAX_TIMERS); the timers hold the actual
 *  mode/duration/alarm config and their own in-progress session. */
                       
                                                                                    
             
                                                        
               
                                                                        
                          
                                                              
                       
                                                                         
                                                                           
                        
                                              
                    
                                                                              
                                    
                              

                                                                      
                                                                             
                           
                                                                          
                                                                    
                              
 

/** A reusable timer configuration that lives inside a card. A card can hold up
 *  to MAX_TIMERS of these (e.g. 5 countdowns + 2 stopwatches). Each carries its
 *  own in-progress session, so switching timers suspends one and resumes another. */
                        
                                           
             
                 
                                                                      
               
                                              
                  
                                                                   
                          
                                                 
                         
                                                                             
                                                                             
                              
                                                           
                
                    
 

/** Alarm behavior at countdown zero. Mirrors a physical alarm-duration switch:
 *  a real chime, a short blip, or silent (visual pulse only). */
                                                     

/** Direction of a card's day-count. */
                                             

/** A normalized view of a card's deadline for rendering. */
                           
                                                                             
               
                     
                                                                     
                  
 

/** One tracked stretch of time against a specific timer (on a card). Closed when ended. */
                          
             
                 
                                             
                  
                                                                                
                  
                                                                   
                          
                    
                                                        
                         
                                                                  
                   
                                                                         
                          
 

                                      

/** What the slotted card is doing right now. Drives the big button. */
                                                                             

/** The single "device slot": which card is in, and which of its timers is active.
 *  Exactly one card and one active timer at a time. The live session lives on the
 *  Timer (not here), so switching timers is suspend/resume, and the slot only
 *  needs to remember which timer is currently selected. */
                       
                        
                                                                   
                               
                                                                            
                                                                         
                   
 

/** A point-in-time snapshot for any interface to render. Pure derived data. */
                           
                  
                    
                                                                            
                      
                                                                                 
                  
                                                                                            
                    
                                                                     
                             
                         
                                                                                     
                    
                                                                          
                         
                                                      
                  
                                                                   
                            
 

/** A full dataset snapshot for backup or moving between storage backends. */
                                  
             
                     
                
                  
                      
             
 

/** Storage contract. SQLite (CLI/Pi) and IndexedDB (web) each implement this.
 *  Deliberately tiny: the core holds all logic, adapters only persist. */
                          
          
                                        
                                            
                               
                                        
                                        
                                                                            
                                                     

                                                         
                                        
                                              
                                                   
                                               
                                         

                       
                                              
                                                    

                                                
                           
                                     
 
